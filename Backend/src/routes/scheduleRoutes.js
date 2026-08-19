import { Router } from 'express';
import * as authNS from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import * as holidayController from '../controllers/holidayController.js';
import * as workScheduleController from '../controllers/workScheduleController.js';
import * as shiftController from '../controllers/shiftController.js';

const protect =
  authNS.protect ||
  authNS.default?.protect ||
  authNS.default;

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus
);

// Holidays
router.get(
  '/holidays',
  requirePermission(
    'HOLIDAY_READ'
  ),
  holidayController.listHolidays
);

router.get(
  '/holidays/upcoming',
  requirePermission(
    'HOLIDAY_READ'
  ),
  holidayController.upcomingHolidays
);

router.post(
  '/holidays',
  checkWriteAccess,
  requirePermission(
    'HOLIDAY_CREATE'
  ),
  holidayController.createHoliday
);

router.put(
  '/holidays/:id',
  checkWriteAccess,
  requirePermission(
    'HOLIDAY_UPDATE'
  ),
  holidayController.updateHoliday
);

router.delete(
  '/holidays/:id',
  checkWriteAccess,
  requirePermission(
    'HOLIDAY_DELETE'
  ),
  holidayController.deleteHoliday
);

// Picking an optional holiday is employee self-service.
router.post(
  '/holidays/:id/pick',
  checkWriteAccess,
  requirePermission(
    'HOLIDAY_READ'
  ),
  holidayController.pickOptional
);

router.delete(
  '/holidays/:id/pick',
  checkWriteAccess,
  requirePermission(
    'HOLIDAY_READ'
  ),
  holidayController.unpickOptional
);

// Work schedules use SHIFT permissions.
router.get(
  '/schedules/my',
  requirePermission(
    'SHIFT_READ'
  ),
  workScheduleController.mySchedule
);

router.get(
  '/schedules',
  requirePermission(
    'SHIFT_READ'
  ),
  workScheduleController.listSchedules
);

router.post(
  '/schedules',
  checkWriteAccess,
  requirePermission(
    'SHIFT_CREATE'
  ),
  workScheduleController.createSchedule
);

router.put(
  '/schedules/:id',
  checkWriteAccess,
  requirePermission(
    'SHIFT_UPDATE'
  ),
  workScheduleController.updateSchedule
);

router.delete(
  '/schedules/:id',
  checkWriteAccess,
  requirePermission(
    'SHIFT_DELETE'
  ),
  workScheduleController.deleteSchedule
);

router.post(
  '/schedules/:id/assign',
  checkWriteAccess,
  requirePermission(
    'SHIFT_UPDATE'
  ),
  workScheduleController.assignSchedule
);

router.post(
  '/schedules/:id/unassign',
  checkWriteAccess,
  requirePermission(
    'SHIFT_UPDATE'
  ),
  workScheduleController.unassignSchedule
);

// Shifts
router.get(
  '/shifts/my',
  requirePermission(
    'SHIFT_READ'
  ),
  shiftController.myShift
);

router.post(
  '/shifts/evaluate',
  requirePermission(
    'SHIFT_READ'
  ),
  shiftController.evaluatePunchApi
);

router.get(
  '/shifts',
  requirePermission(
    'SHIFT_READ'
  ),
  shiftController.listShifts
);

router.post(
  '/shifts',
  checkWriteAccess,
  requirePermission(
    'SHIFT_CREATE'
  ),
  shiftController.createShift
);

router.put(
  '/shifts/:id',
  checkWriteAccess,
  requirePermission(
    'SHIFT_UPDATE'
  ),
  shiftController.updateShift
);

router.delete(
  '/shifts/:id',
  checkWriteAccess,
  requirePermission(
    'SHIFT_DELETE'
  ),
  shiftController.deleteShift
);

router.post(
  '/shifts/:id/assign',
  checkWriteAccess,
  requirePermission(
    'SHIFT_UPDATE'
  ),
  shiftController.assignShift
);

router.get(
  '/shifts/history/:userId',
  requirePermission(
    'SHIFT_READ'
  ),
  shiftController.shiftHistory
);

router.get(
  '/shifts/payroll-inputs',
  requireAnyPermission([
    'SHIFT_READ',
    'PAYROLL_READ',
  ]),
  shiftController.payrollInputs
);

router.get(
  '/my-roster',
  requirePermission(
    'SHIFT_READ'
  ),
  shiftController.myRoster
);

export default router;

export {
  router as scheduleRoutes,
};