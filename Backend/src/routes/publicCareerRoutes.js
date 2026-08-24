import { Router } from 'express';
import {
  publicCareerFilters,
  publicCareerHeader,
  publicCareerJobDetail,
  publicCareerJobs,
} from '../controllers/publicCareerController.js';
import { publicCandidateApplication } from '../controllers/publicCandidateApplicationController.js';
import { publicResumeUpload } from '../middlewares/publicResumeUpload.js';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import {
  careerFilterRules,
  careerHeaderRules,
  careerJobDetailRules,
  careerJobListRules,
} from '../validators/publicCareerValidator.js';
import { candidateApplicationRules } from '../validators/candidateApplicationValidator.js';

const router = Router();

const publicCareerRateLimit = securityRateLimit({
  windowMs: 60 * 1000,
  maximum: 60,
  keyGenerator: (req) => `${req.ip}:public-careers`,
  message: 'Too many career portal requests. Please try again shortly.',
});

const publicApplicationRateLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 5,
  keyGenerator: (req) =>
    `${req.ip}:public-application:${String(req.params.companySlug || '').toLowerCase()}:` +
    `${String(req.params.jobCode || '').toUpperCase()}`,
  message: 'Too many application attempts. Please try again later.',
});

router.use(publicCareerRateLimit);

router.get(
  '/:companySlug',
  careerHeaderRules,
  publicCareerHeader
);

router.get(
  '/:companySlug/jobs',
  careerJobListRules,
  publicCareerJobs
);

router.get(
  '/:companySlug/filters',
  careerFilterRules,
  publicCareerFilters
);

router.get(
  '/:companySlug/jobs/:jobCode',
  careerJobDetailRules,
  publicCareerJobDetail
);

router.post(
  '/:companySlug/jobs/:jobCode/apply',
  publicApplicationRateLimit,
  publicResumeUpload,
  candidateApplicationRules,
  publicCandidateApplication
);

// Public failures never include stack traces or database details.
router.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  const message = statusCode >= 500
    ? 'Career portal is temporarily unavailable'
    : error.message || 'Career portal request failed';

  return res.status(statusCode).json({
    success: false,
    message,
  });
});

export default router;
