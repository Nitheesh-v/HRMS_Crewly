import { Router } from 'express';
import { getPublicStats, getPublicTestimonials } from '../controllers/publicController.js';

const router = Router();

// Public, no auth — safe, anonymized aggregates for the marketing site
router.get('/stats', getPublicStats);
router.get('/testimonials', getPublicTestimonials);

// Health already exists at /api/health; keep this router lean

export default router;
