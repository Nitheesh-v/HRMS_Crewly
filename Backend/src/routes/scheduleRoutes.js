import { Router } from 'express';
import * as authNS from "../middlewares/authMiddleware.js"
import * as holidayController from '../controllers/holidayController.js';
import * as workScheduleController from "../controllers/workScheduleController.js"
import * as shiftController from '../controllers/shiftController.js';

const protect = authNS.protect || authNS.default?.protect || authNS.default;

// self-contained role gate (no dependency on authorize() signature)
const gate = (...roles) => (req, res, next) => {
  const r = req.user?.role;
  if (r && (roles.includes(r) || r === 'SUPER_ADMIN')) return next();
  return res.status(403).json({ statusCode: 403, success: false, message: 'Forbidden' });
};
const HR = gate('COMPANY_ADMIN', 'HR_MANAGER');

const router = Router();
router.use(protect);

// ── Holidays ─────────────────────────────────────────────────────────────
router.get('/holidays', holidayController.listHolidays);
router.get('/holidays/upcoming', holidayController.upcomingHolidays);
router.post('/holidays', HR, holidayController.createHoliday);
router.put('/holidays/:id', HR, holidayController.updateHoliday);
router.delete('/holidays/:id', HR, holidayController.deleteHoliday);
router.post('/holidays/:id/pick', holidayController.pickOptional);
router.delete('/holidays/:id/pick', holidayController.unpickOptional);

// ── Work schedules ───────────────────────────────────────────────────────
router.get('/schedules/my', workScheduleController.mySchedule);
router.get('/schedules', HR, workScheduleController.listSchedules);
router.post('/schedules', HR, workScheduleController.createSchedule);
router.put('/schedules/:id', HR, workScheduleController.updateSchedule);
router.delete('/schedules/:id', HR, workScheduleController.deleteSchedule);
router.post('/schedules/:id/assign', HR, workScheduleController.assignSchedule);
router.post('/schedules/:id/unassign', HR, workScheduleController.unassignSchedule);

// ── Shifts ───────────────────────────────────────────────────────────────
router.get('/shifts/my', shiftController.myShift);
router.post('/shifts/evaluate', shiftController.evaluatePunchApi);
router.get('/shifts', HR, shiftController.listShifts);
router.post('/shifts', HR, shiftController.createShift);
router.put('/shifts/:id', HR, shiftController.updateShift);
router.delete('/shifts/:id', HR, shiftController.deleteShift);
router.post('/shifts/:id/assign', HR, shiftController.assignShift);
router.get('/shifts/history/:userId', HR, shiftController.shiftHistory);
router.get('/shifts/payroll-inputs', HR, shiftController.payrollInputs);

// ── Roster (self) ────────────────────────────────────────────────────────
router.get('/my-roster', shiftController.myRoster);

export default router;
export { router as scheduleRoutes };