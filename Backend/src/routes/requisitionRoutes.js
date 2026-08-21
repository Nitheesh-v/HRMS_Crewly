// ─────────────────────────────────────────────────────────────
// Phase 27.1 / 27.2 — Job Requisition routes
// Mounted at /api/recruitment/requisitions
//
// Same middleware chain as the existing recruitment module:
//   protect → tenantContext → subscription → feature → permission
// Router-level protection is safe here because this router is
// mounted on a specific sub-path (never at API root).
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import {
  createRequisitionRules,
  decisionRules,
  updateRequisitionRules,
} from '../validators/requisitionValidator.js';
import {
  createRequisition,
  decideRequisition,
  deleteRequisition,
  getRequisition,
  listRequisitions,
  submitRequisition,
  updateRequisition,
} from '../controllers/requisitionController.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus,
  requireFeature('recruitment'),
);

router.get(
  '/',
  requireAnyPermission(['REQUISITION_READ', 'REQUISITION_READ_SELF']),
  listRequisitions,
);

router.post(
  '/',
  checkWriteAccess,
  requirePermission('REQUISITION_CREATE'),
  createRequisitionRules,
  createRequisition,
);

router.get(
  '/:id',
  requireAnyPermission(['REQUISITION_READ', 'REQUISITION_READ_SELF']),
  getRequisition,
);

router.patch(
  '/:id',
  checkWriteAccess,
  requireAnyPermission(['REQUISITION_UPDATE', 'REQUISITION_UPDATE_SELF']),
  updateRequisitionRules,
  updateRequisition,
);

router.post(
  '/:id/submit',
  checkWriteAccess,
  requireAnyPermission(['REQUISITION_CREATE', 'REQUISITION_UPDATE_SELF']),
  submitRequisition,
);

router.post(
  '/:id/decision',
  checkWriteAccess,
  requirePermission('REQUISITION_APPROVE'),
  decisionRules,
  decideRequisition,
);

router.delete(
  '/:id',
  checkWriteAccess,
  requireAnyPermission(['REQUISITION_DELETE', 'REQUISITION_UPDATE_SELF']),
  deleteRequisition,
);

export default router;
