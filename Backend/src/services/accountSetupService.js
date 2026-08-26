import crypto from 'node:crypto';
import PasswordResetToken from '../models/PasswordResetToken.js';
import User from '../models/User.js';
import env from '../config/env.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import { accountSetupEmail, sendMail } from '../utils/mailer.js';
import { hashToken, randomToken } from '../utils/securityPolicy.js';
import { recordAudit } from '../utils/securityauditService.js';

const SETUP_TOKEN_HOURS = Math.min(
  168,
  Math.max(1, Number(process.env.ACCOUNT_SETUP_TOKEN_HOURS || 72))
);

const clientOrigin = () =>
  String(env.CLIENT_URL || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '') || 'http://localhost:5173';

export const issueAccountSetupToken = async ({
  companyId,
  userId,
  requestedIp = '',
}) => {
  const rawToken = randomToken(48);
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_HOURS * 60 * 60 * 1000);

  await PasswordResetToken.deleteMany({
    user: userId,
    companyId,
    usedAt: null,
  });

  await PasswordResetToken.create({
    user: userId,
    companyId,
    tokenHash: hashToken(rawToken),
    expiresAt,
    requestedIp: String(requestedIp || '').slice(0, 120),
  });

  return { rawToken, expiresAt };
};

export const sendAccountSetupInvitation = async ({
  companyId,
  user,
  companyName = '',
  companyCode = '',
  designation = '',
  joiningDate = null,
  requestedIp = '',
  actorId = null,
  requestContext = null,
}) => {
  const { rawToken, expiresAt } = await issueAccountSetupToken({
    companyId,
    userId: user._id,
    requestedIp,
  });

  const setupUrl = `${clientOrigin()}/setup-account?token=${encodeURIComponent(rawToken)}`;
  const message = accountSetupEmail({
    name: user.name,
    email: user.email,
    companyName,
    companyCode,
    employeeCode: user.employeeCode || '',
    designation,
    joiningDate,
    setupUrl,
    expiryHours: SETUP_TOKEN_HOURS,
  });

  const delivery = await sendMail({
    to: user.email,
    ...message,
    sensitive: true,
  });

  if (
    delivery.delivered &&
    delivery.mode === 'MOCK' &&
    ['development', 'test'].includes(String(env.NODE_ENV || 'development'))
  ) {
    logger.info(
      `[DEV ONLY] Account setup for ${user.employeeCode || user.email}: ${setupUrl}`
    );
  }

  await recordAudit({
    req: requestContext,
    action: 'ACCOUNT_SETUP_SENT',
    companyId,
    actorId,
    resource: 'User',
    resourceId: user._id,
    metadata: {
      employeeCode: user.employeeCode || '',
      delivered: Boolean(delivery.delivered),
      mode: delivery.mode,
      expiresAt,
    },
    statusCode: delivery.delivered ? 200 : 502,
    critical: true,
  });

  return {
    delivered: Boolean(delivery.delivered),
    mode: delivery.mode,
    expiresAt,
    error: delivery.error || '',
  };
};

export const generateUnusablePassword = () =>
  `Unset!${crypto.randomBytes(24).toString('base64url')}A1`;

export const resendAccountSetupForUser = async ({
  companyId,
  userId,
  actorId,
  companyName = '',
  companyCode = '',
  requestContext = null,
}) => {
  const user = await User.findOne({
    _id: userId,
    companyId,
  })
    .select('_id name email employeeCode designation dateOfJoining status')
    .lean();

  if (!user) throw ApiError.notFound('Employee not found');
  if (user.status !== 'ACTIVE') {
    throw ApiError.conflict('Account setup can only be resent for active employees');
  }

  return sendAccountSetupInvitation({
    companyId,
    user,
    companyName,
    companyCode,
    designation: user.designation || '',
    joiningDate: user.dateOfJoining || null,
    actorId,
    requestContext,
  });
};
