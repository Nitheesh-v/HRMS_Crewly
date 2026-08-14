import { Router } from 'express';
import { auditTrail } from '../middlewares/auditTrail.js';
import authRoutes from './authRoutes.js';
import companyRoutes from './companyRoutes.js';
import departmentRoutes from './departmentRoutes.js';
import userRoutes from './userRoutes.js';
import attendanceRoutes from './attendanceRoutes.js';
import leaveRoutes from './leaveRoutes.js';
import projectRoutes from './projectRoutes.js';
import taskRoutes from './taskRoutes.js';
import payrollRoutes from './payrollRoutes.js';
import recruitmentRoutes from './recruitmentRoutes.js';
import exitRoutes from './exitRoutes.js';
import billingRoutes from './billingRoutes.js';
import systemRoutes from './systemRoutes.js';
import adminRoutes from './adminRoutes.js';
import profileRoutes from './profileRoutes.js';
import selfServiceRoutes from './selfServiceRoutes.js';
import meetingRoutes from './meetingRoutes.js';
import notificationPrefRoutes from './notificationPrefRoutes.js';
import scheduleRoutes from './scheduleRoutes.js';      // Phase 17 ✅
import analyticsRoutes from './analyticsRoutes.js';       // Phase 18 ✅








const router = Router();

router.get('/health', (req, res) =>
  res.json({ success: true, message: 'Crewly HRMS API is healthy', timestamp: new Date().toISOString() })
);

// Phase 8 🛡️ automatic audit/activity log for every mutation (uses req.user at finish time)
router.use(auditTrail);

router.use('/auth', authRoutes);
router.use('/companies', companyRoutes);              // Phase 6.5 ✅
router.use('/departments', departmentRoutes);         // Phase 2 ✅
router.use('/users', userRoutes);                     // Phase 2 ✅
router.use('/attendance', attendanceRoutes);          // Phase 3 ✅
router.use('/leaves', leaveRoutes);                   // Phase 4 ✅
router.use('/projects', projectRoutes);               // Phase 5 ✅
router.use('/tasks', taskRoutes);                     // Phase 5 ✅
router.use('/payroll', payrollRoutes);                // Phase 6 ✅
router.use('/recruitment', recruitmentRoutes);        // Phase 7 ✅
router.use('/exit', exitRoutes);                      // Phase 7 ✅
router.use('/billing', billingRoutes);                // Phase 8 ✅
router.use('/admin-api', adminRoutes);                // Phase 8 ✅ (super admin)
router.use('/', systemRoutes);                        // Phase 8 ✅ (/notifications /audit /permissions /analytics)
router.use('/profile', profileRoutes);
router.use('/meetings', meetingRoutes);
router.use('/', selfServiceRoutes);
router.use('/notification-prefs', notificationPrefRoutes);
router.use(scheduleRoutes);                           // Phase 17 ✅ (/holidays /schedules /shifts /my-roster)
router.use(analyticsRoutes);                              // Phase 18 ✅





export default router;