// ============================================================
// 🧩 SELF-SERVICE ROUTES (Phase 9 + 14 + 15)
// documents · employee files · lifecycle · announcements · support · dashboard
// ============================================================

import express from 'express';
import multer from 'multer';
import * as authMwNS from '../middlewares/authMiddleware.js';
import * as tenantNS from '../middlewares/tenantMiddleware.js';
import * as documentNS from '../controllers/documentController.js';
import * as employeeDocsNS from '../controllers/employeeDocsController.js';
import * as lifecycleNS from '../controllers/lifecycleController.js';
import * as perfNS from '../controllers/performanceController.js';
import * as announcementNS from '../controllers/announcementController.js';
import * as supportNS from '../controllers/supportController.js';
import * as dashboardNS from '../controllers/dashboardController.js';
import { documentUpload } from '../middlewares/uploadMiddleware.js';
import * as expenseNS from '../controllers/expenseController.js';
import * as assetNS from '../controllers/assetController.js';





// Phase 14 — field-name-agnostic uploader for employee-docs routes
const anyDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).any();

const mergeExports = (ns) => ({ ...ns, ...(ns.default && typeof ns.default === 'object' ? ns.default : {}) });
const { protect } = mergeExports(authMwNS);
const tenant = mergeExports(tenantNS);
const tenantContext = tenant.tenantContext;

const documentController = mergeExports(documentNS);
const employeeDocsController = mergeExports(employeeDocsNS);
const lifecycleController = mergeExports(lifecycleNS);
const perfController = mergeExports(perfNS);
const announcementController = mergeExports(announcementNS);
const supportController = mergeExports(supportNS);
const dashboardController = mergeExports(dashboardNS);
const expenseController = mergeExports(expenseNS);
const assetController = mergeExports(assetNS);





const router = express.Router();

router.use(protect, tenantContext);

// 📄 documents (employee self — Phase 9)
router.post('/documents', documentUpload, documentController.uploadDocument);
router.get('/documents/my', documentController.myDocuments);
router.delete('/documents/:id', documentController.deleteDocument);

// 📁 employee files (Phase 14)
router.get('/documents/meta/categories', employeeDocsController.getDocCategories);
router.get('/documents/employee/:userId', employeeDocsController.employeeDocuments);
router.post('/documents/for/:userId', anyDocUpload, employeeDocsController.hrUploadDocument);
router.post('/documents/requests', employeeDocsController.createDocRequest);
router.get('/documents/requests/my', employeeDocsController.myDocRequests);
router.get('/documents/requests', employeeDocsController.listDocRequests);
router.post('/documents/requests/:id/fulfill', anyDocUpload, employeeDocsController.fulfillDocRequest);
router.patch('/documents/requests/:id/cancel', employeeDocsController.cancelDocRequest);

// 🧬 employee lifecycle (Phase 15)
router.get('/lifecycle/my', lifecycleController.myJourney);
router.get('/lifecycle/overview', lifecycleController.overview);
router.get('/lifecycle/company', lifecycleController.companyList);
router.get('/lifecycle/user/:userId', lifecycleController.userJourney);
router.post('/lifecycle/user/:userId/stage', lifecycleController.setStage);
router.post('/lifecycle/user/:userId/promote', lifecycleController.promote);
router.post('/lifecycle/user/:userId/transfer', lifecycleController.transfer);



// 🎯 performance (Phase 16)
router.post('/perf/cycles', perfController.createCycle);
router.get('/perf/cycles', perfController.listCycles);
router.patch('/perf/cycles/:id/status', perfController.transitionCycle);
router.post('/perf/cycles/:id/enroll', perfController.enrollMissing);
router.get('/perf/cycles/:id/my', perfController.myAppraisal);
router.get('/perf/cycles/:id/team', perfController.teamBoard);
router.put('/perf/appraisals/:id/goals', perfController.saveGoals);
router.patch('/perf/appraisals/:id/goals/:goalId/progress', perfController.goalProgress);
router.post('/perf/appraisals/:id/self-review', perfController.submitSelfReview);
router.post('/perf/appraisals/:id/review', perfController.submitReview);
router.get('/perf/history', perfController.history);


// 💸 expenses (Phase 17)
router.post('/expenses', anyDocUpload, expenseController.submitExpense);
router.get('/expenses/my', expenseController.myExpenses);
router.get('/expenses/approvals', expenseController.approvalsQueue);
router.get('/expenses/all', expenseController.allExpenses);
router.post('/expenses/:id/manager-decide', expenseController.managerDecide);
router.post('/expenses/:id/finance-decide', expenseController.financeDecide);
router.post('/expenses/:id/reimburse', expenseController.markReimbursed);
router.patch('/expenses/:id/cancel', expenseController.cancelExpense);

// 🖥 assets (Phase 17)
router.post('/assets', assetController.createAsset);
router.get('/assets', assetController.listAssets);
router.get('/assets/my', assetController.myAssets);
router.post('/assets/:id/assign', assetController.assignAsset);
router.post('/assets/:id/return', assetController.returnAsset);
router.delete('/assets/:id', assetController.deleteAsset);


// 📢 announcements
router.post('/announcements', announcementController.createAnnouncement);
router.get('/announcements', announcementController.listAnnouncements);
router.delete('/announcements/:id', announcementController.deleteAnnouncement);

// 🎫 support
router.post('/support', supportController.createTicket);
router.get('/support/my', supportController.myTickets);
router.get('/support', supportController.listTickets);
router.post('/support/:id/reply', supportController.replyTicket);
router.patch('/support/:id/status', supportController.updateTicketStatus);

// 📊 dashboards
router.get('/dashboard/employee', dashboardController.employeeOverview);
router.get('/dashboard/manager', dashboardController.managerOverview);

export default router;
export { router as selfServiceRoutes };