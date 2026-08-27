import PreOnboardingAccessToken from '../models/PreOnboardingAccessToken.js';
import { hashToken, randomToken } from '../utils/securityPolicy.js';
import ApiError from '../utils/ApiError.js';

const genericFailure = () => ApiError.notFound('Pre-onboarding is unavailable');

export const revokePreOnboardingTokens = async ({
  companyId,
  preOnboardingId,
  reason,
}) => {
  const now = new Date();
  await PreOnboardingAccessToken.updateMany(
    { companyId, preOnboarding: preOnboardingId, revokedAt: null },
    {
      $set: {
        revokedAt: now,
        revokedReason: String(reason || 'REVOKED').slice(0, 200),
        activeKey: null,
      },
    }
  );
};

export const issuePreOnboardingToken = async ({
  companyId,
  preOnboardingId,
  candidateId,
  expiresAt,
  actorId,
}) => {
  await revokePreOnboardingTokens({
    companyId,
    preOnboardingId,
    reason: 'SUPERSEDED',
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rawToken = randomToken(48);
    try {
      const record = await PreOnboardingAccessToken.create({
        companyId,
        preOnboarding: preOnboardingId,
        candidate: candidateId,
        tokenHash: hashToken(rawToken),
        capability: 'PRE_ONBOARDING_PORTAL',
        expiresAt,
        issuedBy: actorId,
      });
      return { rawToken, tokenRecordId: record._id };
    } catch (error) {
      if (error.code !== 11000 || attempt === 2) throw error;
    }
  }

  throw new ApiError(500, 'Secure pre-onboarding access could not be issued');
};

export const resolvePreOnboardingToken = async (rawToken) => {
  if (typeof rawToken !== 'string' || rawToken.length < 40 || rawToken.length > 200) {
    throw genericFailure();
  }

  const tokenRecord = await PreOnboardingAccessToken.findOne({
    tokenHash: hashToken(rawToken),
    capability: 'PRE_ONBOARDING_PORTAL',
  }).select('+tokenHash +activeKey');

  if (!tokenRecord || tokenRecord.revokedAt) throw genericFailure();
  if (tokenRecord.expiresAt.getTime() <= Date.now()) throw genericFailure();

  return tokenRecord;
};

export const recordPreOnboardingTokenView = async (tokenRecordId) => {
  const now = new Date();
  await PreOnboardingAccessToken.updateOne(
    { _id: tokenRecordId, revokedAt: null },
    { $set: { lastViewedAt: now }, $inc: { viewCount: 1 } }
  );
};

export const preOnboardingTokenRateLimitKey = (rawToken) =>
  `preonboard:${hashToken(rawToken || '')}`;
