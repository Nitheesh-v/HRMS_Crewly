import { Router } from "express";
import {
  auditLogDetail,
  auditSummary,
  exportAuditCsv,
  listAuditLogs,
} from "../controllers/auditController.js";
import { authorize, protect } from "../middlewares/authMiddleware.js";
import { tenantContext } from "../middlewares/tenantMiddleware.js";
import { ROLES } from "../utils/constants.js";

const router = Router();

const auditReader = authorize(ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER);

router.use(protect, tenantContext, auditReader);

router.get("/", listAuditLogs);

router.get("/summary", auditSummary);

router.get("/export", exportAuditCsv);

router.get("/:id", auditLogDetail);

export default router;
