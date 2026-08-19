// ============================================================
// 🧩 SELF-SERVICE ROUTES
// Documents · Employee Files · Lifecycle · Performance
// Expenses · Assets · Announcements · Support · Dashboards
// ============================================================

import express from 'express';
import multer from 'multer';

import * as authMwNS from '../middlewares/authMiddleware.js';
import * as tenantNS from '../middlewares/tenantMiddleware.js';

import {
  checkSubscriptionStatus,
  checkWriteAccess,
  checkUsageLimit,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';

import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';

import {
  documentUpload,
} from '../middlewares/uploadMiddleware.js';

import * as documentNS from '../controllers/documentController.js';
import * as employeeDocsNS from '../controllers/employeeDocsController.js';
import * as lifecycleNS from '../controllers/lifecycleController.js';
import * as perfNS from '../controllers/performanceController.js';
import * as announcementNS from '../controllers/announcementController.js';
import * as supportNS from '../controllers/supportController.js';
import * as dashboardNS from '../controllers/dashboardController.js';
import * as expenseNS from '../controllers/expenseController.js';
import * as assetNS from '../controllers/assetController.js';

const mergeExports = (namespace) => ({
  ...namespace,

  ...(namespace.default &&
  typeof namespace.default ===
    'object'
    ? namespace.default
    : {}),
});

const {
  protect,
} = mergeExports(authMwNS);

const {
  tenantContext,
} = mergeExports(tenantNS);

const documentController =
  mergeExports(documentNS);

const employeeDocsController =
  mergeExports(employeeDocsNS);

const lifecycleController =
  mergeExports(lifecycleNS);

const perfController =
  mergeExports(perfNS);

const announcementController =
  mergeExports(announcementNS);

const supportController =
  mergeExports(supportNS);

const dashboardController =
  mergeExports(dashboardNS);

const expenseController =
  mergeExports(expenseNS);

const assetController =
  mergeExports(assetNS);

// Field-name-agnostic document uploader.
const anyDocUpload = multer({
  storage:
    multer.memoryStorage(),

  limits: {
    fileSize:
      10 * 1024 * 1024,
  },
}).any();

const router =
  express.Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus
);

// ============================================================
// 📄 DOCUMENTS — EMPLOYEE SELF-SERVICE
// ============================================================

router.post(
  '/documents',
  checkWriteAccess,

  requireAnyPermission([
    'DOCUMENT_CREATE',
    'DOCUMENT_CREATE_SELF',
  ]),

  requireFeature(
    'documents'
  ),

  checkUsageLimit(
    'fileUploadsMonthly'
  ),

  documentUpload,

  documentController
    .uploadDocument
);

router.get(
  '/documents/my',

  requireAnyPermission([
    'DOCUMENT_READ',
    'DOCUMENT_READ_SELF',
  ]),

  documentController
    .myDocuments
);

router.delete(
  '/documents/:id',
  checkWriteAccess,

  requireAnyPermission([
    'DOCUMENT_DELETE',
    'DOCUMENT_DELETE_SELF',
  ]),

  documentController
    .deleteDocument
);

// ============================================================
// 📁 EMPLOYEE FILES
// ============================================================

router.get(
  '/documents/meta/categories',

  requireAnyPermission([
    'DOCUMENT_READ',
    'DOCUMENT_READ_SELF',
  ]),

  employeeDocsController
    .getDocCategories
);

router.get(
  '/documents/employee/:userId',

  requirePermission(
    'DOCUMENT_READ'
  ),

  employeeDocsController
    .employeeDocuments
);

router.post(
  '/documents/for/:userId',
  checkWriteAccess,

  requirePermission(
    'DOCUMENT_CREATE'
  ),

  requireFeature(
    'documents'
  ),

  checkUsageLimit(
    'fileUploadsMonthly'
  ),

  anyDocUpload,

  employeeDocsController
    .hrUploadDocument
);

// HR asks an employee for a document.
router.post(
  '/documents/requests',
  checkWriteAccess,

  requirePermission(
    'DOCUMENT_CREATE'
  ),

  employeeDocsController
    .createDocRequest
);

// Employee views their own requests.
router.get(
  '/documents/requests/my',

  requireAnyPermission([
    'DOCUMENT_READ',
    'DOCUMENT_READ_SELF',
  ]),

  employeeDocsController
    .myDocRequests
);

// HR views company requests.
router.get(
  '/documents/requests',

  requirePermission(
    'DOCUMENT_READ'
  ),

  employeeDocsController
    .listDocRequests
);

// Employee fulfils their own request.
router.post(
  '/documents/requests/:id/fulfill',
  checkWriteAccess,

  requireAnyPermission([
    'DOCUMENT_CREATE',
    'DOCUMENT_CREATE_SELF',
  ]),

  requireFeature(
    'documents'
  ),

  checkUsageLimit(
    'fileUploadsMonthly'
  ),

  anyDocUpload,

  employeeDocsController
    .fulfillDocRequest
);

// HR cancels a document request.
router.patch(
  '/documents/requests/:id/cancel',
  checkWriteAccess,

  requirePermission(
    'DOCUMENT_UPDATE'
  ),

  employeeDocsController
    .cancelDocRequest
);

// ============================================================
// 🧬 EMPLOYEE LIFECYCLE
// ============================================================

router.get(
  '/lifecycle/my',

  requirePermission(
    'LIFECYCLE_READ_SELF'
  ),

  lifecycleController
    .myJourney
);

router.get(
  '/lifecycle/overview',

  requirePermission(
    'LIFECYCLE_READ'
  ),

  lifecycleController
    .overview
);

router.get(
  '/lifecycle/company',

  requirePermission(
    'LIFECYCLE_READ'
  ),

  lifecycleController
    .companyList
);

router.get(
  '/lifecycle/user/:userId',

  requirePermission(
    'LIFECYCLE_READ'
  ),

  lifecycleController
    .userJourney
);

router.post(
  '/lifecycle/user/:userId/stage',
  checkWriteAccess,

  requirePermission(
    'LIFECYCLE_UPDATE'
  ),

  lifecycleController
    .setStage
);

router.post(
  '/lifecycle/user/:userId/promote',
  checkWriteAccess,

  requirePermission(
    'LIFECYCLE_UPDATE'
  ),

  lifecycleController
    .promote
);

router.post(
  '/lifecycle/user/:userId/transfer',
  checkWriteAccess,

  requirePermission(
    'LIFECYCLE_UPDATE'
  ),

  lifecycleController
    .transfer
);

// ============================================================
// 🎯 PERFORMANCE
// ============================================================

router.post(
  '/perf/cycles',
  checkWriteAccess,

  requirePermission(
    'PERFORMANCE_CREATE'
  ),

  requireFeature(
    'performance'
  ),

  perfController
    .createCycle
);

router.get(
  '/perf/cycles',

  requireAnyPermission([
    'PERFORMANCE_READ',
    'PERFORMANCE_READ_SELF',
  ]),

  requireFeature(
    'performance'
  ),

  perfController
    .listCycles
);

router.patch(
  '/perf/cycles/:id/status',
  checkWriteAccess,

  requirePermission(
    'PERFORMANCE_APPROVE'
  ),

  requireFeature(
    'performance'
  ),

  perfController
    .transitionCycle
);

router.post(
  '/perf/cycles/:id/enroll',
  checkWriteAccess,

  requirePermission(
    'PERFORMANCE_CREATE'
  ),

  requireFeature(
    'performance'
  ),

  perfController
    .enrollMissing
);

router.get(
  '/perf/cycles/:id/my',

  requireAnyPermission([
    'PERFORMANCE_READ',
    'PERFORMANCE_READ_SELF',
  ]),

  requireFeature(
    'performance'
  ),

  perfController
    .myAppraisal
);

router.get(
  '/perf/cycles/:id/team',

  requirePermission(
    'PERFORMANCE_READ'
  ),

  requireFeature(
    'performance'
  ),

  perfController
    .teamBoard
);

router.put(
  '/perf/appraisals/:id/goals',
  checkWriteAccess,

  requirePermission(
    'PERFORMANCE_UPDATE'
  ),

  requireFeature(
    'performance'
  ),

  perfController
    .saveGoals
);

router.patch(
  '/perf/appraisals/:id/goals/:goalId/progress',
  checkWriteAccess,

  requireAnyPermission([
    'PERFORMANCE_UPDATE',
    'PERFORMANCE_UPDATE_SELF',
  ]),

  requireFeature(
    'performance'
  ),

  perfController
    .goalProgress
);

router.post(
  '/perf/appraisals/:id/self-review',
  checkWriteAccess,

  requirePermission(
    'PERFORMANCE_UPDATE_SELF'
  ),

  requireFeature(
    'performance'
  ),

  perfController
    .submitSelfReview
);

router.post(
  '/perf/appraisals/:id/review',
  checkWriteAccess,

  requirePermission(
    'PERFORMANCE_APPROVE'
  ),

  requireFeature(
    'performance'
  ),

  perfController
    .submitReview
);

router.get(
  '/perf/history',

  requireAnyPermission([
    'PERFORMANCE_READ',
    'PERFORMANCE_READ_SELF',
  ]),

  requireFeature(
    'performance'
  ),

  perfController
    .history
);

// ============================================================
// 💸 EXPENSES
// ============================================================

router.post(
  '/expenses',
  checkWriteAccess,

  requireAnyPermission([
    'EXPENSE_CREATE',
    'EXPENSE_CREATE_SELF',
  ]),

  anyDocUpload,

  expenseController
    .submitExpense
);

router.get(
  '/expenses/my',

  requireAnyPermission([
    'EXPENSE_READ',
    'EXPENSE_READ_SELF',
  ]),

  expenseController
    .myExpenses
);

router.get(
  '/expenses/approvals',

  requirePermission(
    'EXPENSE_APPROVE'
  ),

  expenseController
    .approvalsQueue
);

router.get(
  '/expenses/all',

  requirePermission(
    'EXPENSE_READ'
  ),

  expenseController
    .allExpenses
);

router.post(
  '/expenses/:id/manager-decide',
  checkWriteAccess,

  requirePermission(
    'EXPENSE_APPROVE'
  ),

  expenseController
    .managerDecide
);

router.post(
  '/expenses/:id/finance-decide',
  checkWriteAccess,

  requirePermission(
    'EXPENSE_APPROVE'
  ),

  expenseController
    .financeDecide
);

router.post(
  '/expenses/:id/reimburse',
  checkWriteAccess,

  requirePermission(
    'EXPENSE_APPROVE'
  ),

  expenseController
    .markReimbursed
);

router.patch(
  '/expenses/:id/cancel',
  checkWriteAccess,

  requireAnyPermission([
    'EXPENSE_UPDATE',
    'EXPENSE_UPDATE_SELF',
  ]),

  expenseController
    .cancelExpense
);

// ============================================================
// 🖥 ASSETS
// ============================================================

router.post(
  '/assets',
  checkWriteAccess,

  requirePermission(
    'ASSET_CREATE'
  ),

  assetController
    .createAsset
);

router.get(
  '/assets',

  requirePermission(
    'ASSET_READ'
  ),

  assetController
    .listAssets
);

router.get(
  '/assets/my',

  requireAnyPermission([
    'ASSET_READ',
    'ASSET_READ_SELF',
  ]),

  assetController
    .myAssets
);

router.post(
  '/assets/:id/assign',
  checkWriteAccess,

  requirePermission(
    'ASSET_UPDATE'
  ),

  assetController
    .assignAsset
);

router.post(
  '/assets/:id/return',
  checkWriteAccess,

  requirePermission(
    'ASSET_UPDATE'
  ),

  assetController
    .returnAsset
);

router.delete(
  '/assets/:id',
  checkWriteAccess,

  requirePermission(
    'ASSET_DELETE'
  ),

  assetController
    .deleteAsset
);

// ============================================================
// 📢 ANNOUNCEMENTS
// ============================================================

router.post(
  '/announcements',
  checkWriteAccess,

  requirePermission(
    'ANNOUNCEMENT_CREATE'
  ),

  announcementController
    .createAnnouncement
);

router.get(
  '/announcements',

  requirePermission(
    'ANNOUNCEMENT_READ'
  ),

  announcementController
    .listAnnouncements
);

router.delete(
  '/announcements/:id',
  checkWriteAccess,

  requirePermission(
    'ANNOUNCEMENT_DELETE'
  ),

  announcementController
    .deleteAnnouncement
);

// ============================================================
// 🎫 SUPPORT
// ============================================================

router.post(
  '/support',
  checkWriteAccess,

  requirePermission(
    'SUPPORT_CREATE'
  ),

  supportController
    .createTicket
);

router.get(
  '/support/my',

  requireAnyPermission([
    'SUPPORT_READ',
    'SUPPORT_READ_SELF',
  ]),

  supportController
    .myTickets
);

router.get(
  '/support',

  requirePermission(
    'SUPPORT_READ'
  ),

  supportController
    .listTickets
);

router.post(
  '/support/:id/reply',
  checkWriteAccess,

  requireAnyPermission([
    'SUPPORT_UPDATE',
    'SUPPORT_UPDATE_SELF',
    'SUPPORT_MANAGE',
  ]),

  supportController
    .replyTicket
);

router.patch(
  '/support/:id/status',
  checkWriteAccess,

  requirePermission(
    'SUPPORT_MANAGE'
  ),

  supportController
    .updateTicketStatus
);

// ============================================================
// 📊 DASHBOARDS
// Existing dashboard controllers remain role/scope aware.
// ============================================================

router.get(
  '/dashboard/employee',
  dashboardController
    .employeeOverview
);

router.get(
  '/dashboard/manager',
  dashboardController
    .managerOverview
);

export default router;

export {
  router as selfServiceRoutes,
};