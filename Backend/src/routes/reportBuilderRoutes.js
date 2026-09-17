// ============================================================
// REPORT BUILDER ROUTES — Insights → Report Builder (/app/reports).
//
// Wires the (previously unmounted) reportBuilderController to its
// endpoints. Mounted at /api (see routes/index.js).
//
// Guards mirror the controller's own contract: HR sees the company,
// Managers/TLs see their subtree (enforced in the controller), the
// payroll module is HR-only (enforced in the controller).
// ============================================================
import express from 'express';

import { authorize, protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { ROLES } from '../utils/constants.js';
import {
  reportExportValidator,
  reportRunValidator,
} from '../validators/insightsValidator.js';
import {
  builderMeta,
  exportReport,
  runReport,
} from '../controllers/reportBuilderController.js';

const router = express.Router();

const SENIOR = [
  ROLES.COMPANY_ADMIN,
  ROLES.HR_MANAGER,
  ROLES.MANAGER,
  ROLES.TEAM_LEAD,
];

router.get(
  '/report-builder/meta',
  protect,
  tenantContext,
  authorize(...SENIOR),
  builderMeta
);
router.post(
  '/report-builder/run',
  protect,
  tenantContext,
  authorize(...SENIOR),
  reportRunValidator,
  runReport
);
router.post(
  '/report-builder/export',
  protect,
  tenantContext,
  authorize(...SENIOR),
  reportExportValidator,
  exportReport
);

export default router;
