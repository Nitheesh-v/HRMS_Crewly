// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP ROUTES
//
//  Mounted at /api/payroll/payslips (see routes/index.js).
//
//  Two audiences, one router:
//    · /mine/*     — the employee salary portal (§14). The employee id comes
//                    from the JWT, never from the URL, and PAYSLIP_READ_SELF
//                    grants nothing else.
//    · everything else — payroll / HR / finance, permission + scope gated.
//
//  Deliberately NOT touched: the pre-29.9 legacy payslip download at
//  GET /api/payroll/:id/payslip (models/Payroll.js). 29.9 leaves it exactly
//  as it is — the same call 29.3 made for the legacy salary structure API.
// ═══════════════════════════════════════════════════════════════════════════
import express from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { requireAnyPermission, requirePermission } from '../middlewares/permissionMiddleware.js';
import { checkWriteAccess, requireFeature } from '../middlewares/subscriptionAccess.js';
import payslipScope from '../middlewares/payslipScope.js';

import {
  downloadBulkFile,
  downloadRegister,
  downloadMyPayslip,
  downloadPayslip,
  emailMonthPayslips,
  emailPayslip,
  generatePayslips,
  getMyPayslip,
  getMyPayslips,
  getPayslip,
  getPayslipDashboard,
  listBulkDownloads,
  listPayslips,
  regeneratePayslip,
  requestBulkDownload,
} from '../controllers/payslipController.js';

import {
  bulkDownloadValidator,
  bulkFileIdParamValidator,
  emailMonthValidator,
  generatePayslipsValidator,
  payslipIdParamValidator,
  payslipListQueryValidator,
} from '../validators/payslipValidator.js';

const router = express.Router();

router.use(protect, tenantContext);

// §14 — the employee portal. PAYSLIP_READ_SELF grants the /mine routes only.
const selfAccess = [
  requirePermission('PAYSLIP_READ_SELF'),
  requireFeature('payroll'),
];

// Reading the company's payslips: payroll, HR and finance (§4).
const readAccess = [
  requireAnyPermission(['PAYSLIP_READ', 'PAYSLIP_GENERATE', 'PAYSLIP_RELEASE', 'PAYSLIP_RERELEASE']),
  requireFeature('payroll'),
  payslipScope,
];

const writeAccess = (permission) => [
  checkWriteAccess,
  requirePermission(permission),
  requireFeature('payroll'),
  payslipScope,
];

// ── Employee salary portal (§14 / §16 / §29) ───────────────────────────────
// Declared first so `/mine` can never be mistaken for a :payslipId.

router.get('/mine', ...selfAccess, getMyPayslips);
router.get('/mine/:payslipId', ...selfAccess, payslipIdParamValidator, getMyPayslip);
router.get('/mine/:payslipId/pdf', ...selfAccess, payslipIdParamValidator, downloadMyPayslip);

// ── Admin / payroll side (§27) ─────────────────────────────────────────────

// §27.1 — dashboard with the counters for a month.
router.get('/dashboard', ...readAccess, payslipListQueryValidator, getPayslipDashboard);

// §27.3 — the payslip list, filterable by month / year / FY / search (§15).
router.get('/', ...readAccess, payslipListQueryValidator, listPayslips);

// §4 — payroll register (CSV download), before /:payslipId so the path wins.
router.get('/register', ...readAccess, payslipListQueryValidator, downloadRegister);

// §17 — generate every payslip for a month (queued for large companies).
router.post('/generate', ...writeAccess('PAYSLIP_GENERATE'), generatePayslipsValidator, generatePayslips);

// §19 / §24 — bulk email, background when possible.
router.post('/email', ...writeAccess('PAYSLIP_RELEASE'), emailMonthValidator, emailMonthPayslips);

// §18 — bulk download requests and history.
router.post('/bulk-download', ...writeAccess('PAYSLIP_READ'), bulkDownloadValidator, requestBulkDownload);
router.get('/bulk-download', ...readAccess, payslipListQueryValidator, listBulkDownloads);
router.get('/bulk-download/:fileId', ...readAccess, bulkFileIdParamValidator, downloadBulkFile);

// §19 — email one payslip.
router.post('/:payslipId/email', ...writeAccess('PAYSLIP_RELEASE'), payslipIdParamValidator, emailPayslip);

// §22 — regenerate the PDF from the stored snapshot.
router.post(
  '/:payslipId/regenerate',
  ...writeAccess('PAYSLIP_RERELEASE'),
  payslipIdParamValidator,
  regeneratePayslip,
);

// §16 — preview (JSON) and PDF download.
router.get('/:payslipId/pdf', ...readAccess, payslipIdParamValidator, downloadPayslip);
router.get('/:payslipId', ...readAccess, payslipIdParamValidator, getPayslip);

export default router;
