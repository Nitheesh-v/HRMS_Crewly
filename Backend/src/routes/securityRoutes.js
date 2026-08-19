import { Router } from "express";
import {
  getSecuritySettings,
  listSecurityEvents,
  securityDashboard,
  updateSecuritySettings,
} from "../controllers/securityController.js";
import { authorize, protect } from "../middlewares/authMiddleware.js";
import { tenantContext } from "../middlewares/tenantMiddleware.js";
import { ROLES } from "../utils/constants.js";

const router = Router();

const securityReader = authorize(ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER);

router.use(protect, tenantContext);

router.get("/dashboard", securityReader, securityDashboard);

router.get("/events", securityReader, listSecurityEvents);

router.get("/settings", securityReader, getSecuritySettings);

router.patch(
  "/settings",
  authorize(ROLES.COMPANY_ADMIN),
  updateSecuritySettings,
);

export default router;
