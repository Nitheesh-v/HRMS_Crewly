// ============================================================
// 🧪 DEMO TENANT SEED — development-only, real documents in a real DB.
// Creates ONE trial tenant (company + subscription), an HR admin, two
// employees and a handful of support tickets so the Phase 38 helpdesk
// can be exercised end-to-end on a local/full run.
// Idempotent: skips everything when the demo company already exists.
//   usage: npm run seed:demo        (needs MONGO_URI like `npm run seed`)
// ============================================================
import connectDB from './config/db.js';
import logger from './config/logger.js';
import Company from './models/Company.js';
import Subscription from './models/Subscription.js';
import User from './models/User.js';
import SupportTicket from './models/SupportTicket.js';
import { ROLES } from './utils/constants.js';

const DEMO_CODE = 'crewlydemo';
const PASSWORD = 'Demo@123';

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000);

const seedDemoTenant = async () => {
  await connectDB();

  const existing = await Company.findOne({ code: DEMO_CODE });
  if (existing) {
    logger.warn(`Demo tenant already exists (${existing.name}) — nothing to do.`);
    logger.warn(`   HR login       : hr@crewly.dev / ${PASSWORD}`);
    logger.warn(`   Employee login : priya@crewly.dev / ${PASSWORD}`);
    process.exit(0);
  }

  const [company] = await Company.create([{ name: 'Crewly Demo Pvt Ltd', code: DEMO_CODE, email: 'people@crewly.dev' }]);

  const trialStart = new Date();
  const trialEnd = new Date(trialStart.getTime() + 30 * 24 * 3600_000);
  const [subscription] = await Subscription.create([
    {
      company: company._id,
      plan: 'TRIAL',
      status: 'TRIAL',
      startDate: trialStart,
      endDate: trialEnd,
      trialEndDate: trialEnd,
      renewalDate: trialEnd,
      readOnly: false,
    },
  ]);
  company.subscription = subscription._id;
  await company.save();

  const [hr] = await User.create([
    { name: 'Arun Kumar (HR)', email: 'hr@crewly.dev', password: PASSWORD, role: ROLES.HR_MANAGER, companyId: company._id, passwordChangedAt: new Date() },
  ]);
  const employees = await User.create([
    { name: 'Priya Raman', email: 'priya@crewly.dev', password: PASSWORD, role: ROLES.EMPLOYEE, companyId: company._id, passwordChangedAt: new Date() },
    { name: 'Mohammed Irfan', email: 'irfan@crewly.dev', password: PASSWORD, role: ROLES.EMPLOYEE, companyId: company._id, passwordChangedAt: new Date() },
  ]);
  const [priya, irfan] = employees;

  await SupportTicket.create([
    {
      companyId: company._id, user: priya._id, subject: 'Laptop won’t join office Wi-Fi after update',
      category: 'IT', priority: 'HIGH', status: 'OPEN',
      message: 'After yesterday’s OS update my laptop keeps dropping from CREWLY-OFFICE. Rebooted twice, no luck.',
      createdAt: hoursAgo(3), updatedAt: hoursAgo(3),
    },
    {
      companyId: company._id, user: priya._id, subject: 'PF amount wrong in June payslip',
      category: 'PAYROLL', priority: 'MEDIUM', status: 'IN_PROGRESS',
      message: 'June payslip shows PF at 12% of basic but my structure says 15%. Please check.',
      replies: [{ by: hr._id, message: 'Thanks Priya — pulling your payroll register now, will confirm by EOD.', createdAt: hoursAgo(20) }],
      createdAt: hoursAgo(26), updatedAt: hoursAgo(20),
    },
    {
      companyId: company._id, user: priya._id, subject: 'Reimbursement claim stuck since last month',
      category: 'OTHER', priority: 'MEDIUM', status: 'OPEN',
      message: 'My travel claim EXP-1142 has been “under review” for three weeks. Finance hasn’t responded.',
      createdAt: hoursAgo(50), updatedAt: hoursAgo(50),
    },
    {
      companyId: company._id, user: priya._id, subject: 'Access card not working on 2nd floor',
      category: 'FACILITIES', priority: 'LOW', status: 'RESOLVED',
      message: 'Card reads fine at the lobby but fails at the 2nd floor reader.',
      replies: [
        { by: hr._id, message: 'Re-encoded your card at the admin desk. Please try and confirm.', createdAt: hoursAgo(70) },
        { by: priya._id, message: 'Works now, thanks!', createdAt: hoursAgo(68) },
      ],
      createdAt: hoursAgo(96), updatedAt: hoursAgo(68),
    },
    {
      companyId: company._id, user: irfan._id, subject: 'Salary credit delayed for contract staff',
      category: 'PAYROLL', priority: 'CRITICAL', status: 'OPEN',
      message: 'Three contract staff in my team haven’t received credits yet this month.',
      createdAt: hoursAgo(6), updatedAt: hoursAgo(6),
    },
    {
      companyId: company._id, user: irfan._id, subject: 'Need employment verification letter',
      category: 'HR', priority: 'MEDIUM', status: 'IN_PROGRESS',
      message: 'My bank needs a verification letter with joining date and designation.',
      replies: [{ by: hr._id, message: 'Drafting the letter on company letterhead today.', createdAt: hoursAgo(10) }],
      createdAt: hoursAgo(30), updatedAt: hoursAgo(10),
    },
  ]);

  logger.info('🧪 Demo tenant seeded.');
  logger.info(`   Company code   : ${DEMO_CODE}`);
  logger.info(`   HR login       : hr@crewly.dev / ${PASSWORD}`);
  logger.info(`   Employee login : priya@crewly.dev / ${PASSWORD}  (also irfan@crewly.dev)`);
  process.exit(0);
};

seedDemoTenant().catch((err) => {
  logger.error(`Demo seed failed: ${err.message}`);
  process.exit(1);
});
