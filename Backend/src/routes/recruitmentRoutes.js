import { Router } from 'express';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext, readOnlyIfExpired } from '../middlewares/tenantMiddleware.js';
import { ROLES } from '../utils/constants.js';
import {
  createJobRules, updateJobRules, candidateRules, stageRules, offerRules,
} from '../validators/recruitmentValidator.js';
import {
  listJobs, createJob, updateJob,
  listCandidates, addCandidate, updateStage, updateOffer, convertCandidate,
} from '../controllers/recruitmentController.js';

const router = Router();
router.use(protect, tenantContext, readOnlyIfExpired);

// Recruitment is an HR function (per requirements: Company Admin + HR Manager)
const HR = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

router.get('/jobs', authorize(...HR), listJobs);
router.post('/jobs', authorize(...HR), createJobRules, createJob);
router.patch('/jobs/:id', authorize(...HR), updateJobRules, updateJob);

router.get('/candidates', authorize(...HR), listCandidates);
router.post('/candidates', authorize(...HR), candidateRules, addCandidate);
router.patch('/candidates/:id/stage', authorize(...HR), stageRules, updateStage);
router.patch('/candidates/:id/offer', authorize(...HR), offerRules, updateOffer);
router.post('/candidates/:id/convert', authorize(...HR), convertCandidate);

export default router;