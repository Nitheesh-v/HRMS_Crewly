import connectDB from './config/db.js';
import logger from './config/logger.js';
import User from './models/User.js';
import { ROLES, SUPER_ADMIN_COMPANY_CODE } from './utils/constants.js';

const seed = async () => {
  await connectDB();

  const email = process.env.SUPER_ADMIN_EMAIL || 'admin@crewly.com';
  const password = process.env.SUPER_ADMIN_PASSWORD || 'Admin@123';

  const existing = await User.findOne({ role: ROLES.SUPER_ADMIN });
  if (existing) {
    logger.warn(`Super Admin already exists (${existing.email}) — nothing to do.`);
    process.exit(0);
  }

  await User.create({
    name: 'Crewly Super Admin',
    email,
    password,
    role: ROLES.SUPER_ADMIN,
    companyId: null,
  });

  logger.info('✅ Super Admin created successfully');
  logger.info(`   → Login company code : ${SUPER_ADMIN_COMPANY_CODE}`);
  logger.info(`   → Email              : ${email}`);
  logger.info(`   → Password           : ${password}`);
  process.exit(0);
};

seed().catch((err) => {
  logger.error(`Seed failed: ${err.message}`);
  process.exit(1);
});