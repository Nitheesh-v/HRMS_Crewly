// ============================================================
// 🧩 SELF-SERVICE ROUTES (Phase 9)
// documents · announcements · support · dashboard
// Role rules live inside controllers (simple includes-checks).
// 📅 Meetings moved to routes/meetingRoutes.js (Phase 12)
// ============================================================

import express from 'express';
import * as authMwNS from '../middlewares/authMiddleware.js';
import * as tenantNS from '../middlewares/tenantMiddleware.js';
import * as documentNS from '../controllers/documentController.js';
import * as announcementNS from '../controllers/announcementController.js';
import * as supportNS from '../controllers/supportController.js';
import * as dashboardNS from '../controllers/dashboardController.js';
import { documentUpload } from '../middlewares/uploadMiddleware.js';

const mergeExports = (ns) => ({ ...ns, ...(ns.default && typeof ns.default === 'object' ? ns.default : {}) });
const { protect } = mergeExports(authMwNS);
const tenant = mergeExports(tenantNS);
const tenantContext = tenant.tenantContext; // attaches req.company + req.companyId

const documentController = mergeExports(documentNS);
const announcementController = mergeExports(announcementNS);
const supportController = mergeExports(supportNS);
const dashboardController = mergeExports(dashboardNS);

const router = express.Router();

router.use(protect, tenantContext); // every self-service API is company-scoped

// 📄 documents
router.post('/documents', documentUpload, documentController.uploadDocument);
router.get('/documents/my', documentController.myDocuments);
router.delete('/documents/:id', documentController.deleteDocument);

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