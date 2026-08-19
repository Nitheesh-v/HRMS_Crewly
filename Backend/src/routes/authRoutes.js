import { Router } from "express";
import {
  getMe,
  login,
  registerCompany,
} from "../controllers/authController.js";
import * as securityAuthNS from "../controllers/securityAuthController.js";
import { protect } from "../middlewares/authMiddleware.js";
import { tenantContext } from "../middlewares/tenantMiddleware.js";
import * as rateLimitNS from "../middlewares/securityRateLimit.js";
import {
  loginValidator,
  registerCompanyValidator,
  validate,
} from "../validators/authValidator.js";

const router = Router();

const mergeExports = (namespace) => ({
  ...namespace,
  ...(namespace.default && typeof namespace.default === "object"
    ? namespace.default
    : {}),
});

const securityAuth = mergeExports(securityAuthNS);
const rateLimits = mergeExports(rateLimitNS);

const pickHandler = (...names) =>
  names
    .map((name) => securityAuth[name])
    .find((handler) => typeof handler === "function");

const noRateLimit = (req, res, next) => next();

const loginRateLimit =
  rateLimits.loginRateLimit || rateLimits.loginLimiter || noRateLimit;

const refreshRateLimit =
  rateLimits.refreshRateLimit || rateLimits.refreshLimiter || noRateLimit;

const passwordRateLimit =
  rateLimits.passwordRateLimit ||
  rateLimits.passwordLimiter ||
  rateLimits.passwordResetLimiter ||
  noRateLimit;

const refresh = pickHandler("refresh", "refreshAccessToken", "refreshToken");

const forgotPassword = pickHandler("forgotPassword");

const resetPassword = pickHandler("resetPassword");

const logout = pickHandler("logout", "logoutCurrentSession");

const logoutAll = pickHandler("logoutAll", "logoutAllSessions");

const activeSessions = pickHandler(
  "sessionsWithHistory",
  "activeSessions",
  "getSessions",
  "listSessions",
);

const revokeActiveSession = pickHandler(
  "revokeActiveSession",
  "revokeSession",
  "deleteSession",
);

const changePassword = pickHandler("changePassword");

const requiredHandlers = {
  refresh,
  forgotPassword,
  resetPassword,
  logout,
  logoutAll,
  activeSessions,
  revokeActiveSession,
  changePassword,
};

for (const [name, handler] of Object.entries(requiredHandlers)) {
  if (typeof handler !== "function") {
    throw new Error(`securityAuthController.js is missing the ${name} handler`);
  }
}

const secured = [protect, tenantContext];

// Public customer authentication
router.post(
  "/register-company",
  loginRateLimit,
  registerCompanyValidator,
  validate,
  registerCompany,
);

router.post("/login", loginRateLimit, loginValidator, validate, login);

router.post("/refresh", refreshRateLimit, refresh);

router.post("/forgot-password", passwordRateLimit, forgotPassword);

router.post("/reset-password", passwordRateLimit, resetPassword);

// Protected customer authentication
router.get("/me", ...secured, getMe);

router.post("/logout", ...secured, logout);

router.post("/logout-all", ...secured, logoutAll);

router.get("/sessions", ...secured, activeSessions);

router.delete("/sessions/:sessionId", ...secured, revokeActiveSession);

router.patch("/change-password", ...secured, passwordRateLimit, changePassword);

export default router;
