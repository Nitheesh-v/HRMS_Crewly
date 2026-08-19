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
  listJobs,
  createJob,
  updateJob,
  listCandidates,
  addCandidate,
  updateStage,
  updateOffer,
  convertCandidate,
} from '../controllers/recruitmentController.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus,
  requireFeature(
    'recruitment'
  )
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
  requireAnyPermission([
    'CANDIDATE_READ',
    'RECRUITMENT_READ',
  ]),
  listCandidates
);

router.post(
  '/candidates',
  checkWriteAccess,
  requireAnyPermission([
    'CANDIDATE_CREATE',
    'RECRUITMENT_CREATE',
  ]),
  checkUsageLimit(
    'recruitmentCandidatesMonthly'
  ),
  candidateRules,
  addCandidate
);

router.patch(
  '/candidates/:id/stage',
  checkWriteAccess,
  requireAnyPermission([
    'CANDIDATE_UPDATE',
    'RECRUITMENT_UPDATE',
  ]),
  stageRules,
  updateStage
);

router.patch(
  '/candidates/:id/offer',
  checkWriteAccess,
  requireAnyPermission([
    'RECRUITMENT_APPROVE',
    'CANDIDATE_UPDATE',
  ]),
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