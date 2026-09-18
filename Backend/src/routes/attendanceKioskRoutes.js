// ─────────────────────────────────────────────────────────────
// Phase 31.14 — kiosk punch router. Mounted at /api/kiosk.
//
// This is a SEPARATE trust boundary from employee/HR APIs:
//   - /session is public but strictly rate-limited (guessing the
//     256-bit station secret is infeasible; the limit stops abuse);
//   - /identify + /punch require a kiosk JWT (kioskAuth), which
//     authenticates the shared device — never an employee.
// Employee JWTs cannot reach these handlers (kioskAuth rejects
// them: no typ:'kiosk' claim), and kiosk JWTs cannot reach any
// other router (only this one mounts kioskAuth).
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';

import { kioskAuth } from '../middlewares/kioskAuth.js';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import {
  kioskIdentifyValidator,
  kioskPunchValidator,
  kioskSessionValidator,
} from '../validators/attendanceCaptureValidator.js';
import {
  postKioskIdentify,
  postKioskPunch,
  postKioskSession,
} from '../controllers/attendanceKioskController.js';

const router = Router();

// Secret guessing: 5 attempts/minute per IP + station.
const sessionRateLimit = securityRateLimit({
  windowMs: 60000,
  maximum: 5,
  keyGenerator: (req) => `${req.ip}:kiosk-session:${req.body?.stationId || ''}`,
  message: 'Too many station sign-in attempts. Please wait one minute.',
});

// Punch bursts at shift change: generous per-station cap that
// still stops automated abuse.
const punchRateLimit = securityRateLimit({
  windowMs: 60000,
  maximum: 120,
  keyGenerator: (req) => `${req.ip}:kiosk-punch:${req.kiosk?.stationId || ''}`,
  message: 'Too many kiosk requests. Please try again shortly.',
});

// 31.14 completion — PIN guessing: strict per-code cap inside the
// authenticated station (kioskAuth already ran, so req.kiosk is
// trusted). Per-code keying means one attacked code never locks
// the whole terminal, and the company+station segments stop
// cross-tenant / cross-station bypass.
const identifyRateLimit = securityRateLimit({
  windowMs: 10 * 60000,
  maximum: 10,
  keyGenerator: (req) =>
    `${req.ip}:kiosk-pin:${req.kiosk?.companyId || ''}:${req.kiosk?.stationId || ''}:${String(req.body?.employeeCode || '').trim().toUpperCase()}`,
  message: 'Too many verification attempts for this employee code. Please wait ten minutes.',
});

// Shared-device sign-in (public + rate-limited).
router.post('/session', sessionRateLimit, kioskSessionValidator, postKioskSession);

// Everything below rides the kiosk session (device identity).
router.use(kioskAuth, checkSubscriptionStatus);

router.post(
  '/identify',
  punchRateLimit,
  checkWriteAccess,
  kioskIdentifyValidator,
  postKioskIdentify
);

router.post(
  '/punch',
  punchRateLimit,
  checkWriteAccess,
  kioskPunchValidator,
  postKioskPunch
);

export default router;
