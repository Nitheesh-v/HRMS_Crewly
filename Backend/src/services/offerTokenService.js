import OfferAccessToken from '../models/OfferAccessToken.js';
import { hashToken, randomToken } from '../utils/securityPolicy.js';
import ApiError from '../utils/ApiError.js';

const genericFailure = () => ApiError.notFound('Offer is unavailable');

export const revokeOfferTokens = async ({ companyId, offerId, reason }) => {
  const now = new Date();
  await OfferAccessToken.updateMany(
    { companyId, offer: offerId, revokedAt: null },
    {
      $set: {
        revokedAt: now,
        revokedReason: String(reason || 'REVOKED').slice(0, 200),
        activeKey: null,
      },
    }
  );
};

export const restoreOfferTokensRevokedFor = async ({ companyId, offerId, reason }) => {
  await OfferAccessToken.updateMany(
    { companyId, offer: offerId, revokedReason: reason, finalAction: null },
    {
      $set: {
        revokedAt: null,
        revokedReason: '',
        activeKey: 'ACTIVE',
      },
    }
  );
};

export const issueOfferToken = async ({ companyId, offerId, expiresAt, actorId }) => {
  await revokeOfferTokens({ companyId, offerId, reason: 'SUPERSEDED' });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rawToken = randomToken(48);
    try {
      const record = await OfferAccessToken.create({
        companyId,
        offer: offerId,
        tokenHash: hashToken(rawToken),
        expiresAt,
        issuedBy: actorId,
      });
      return { rawToken, tokenRecordId: record._id };
    } catch (error) {
      if (error.code !== 11000 || attempt === 2) throw error;
    }
  }

  throw new ApiError(500, 'Secure offer access could not be issued');
};

export const resolveOfferToken = async (rawToken) => {
  if (typeof rawToken !== 'string' || rawToken.length < 40 || rawToken.length > 200) {
    throw genericFailure();
  }

  const tokenRecord = await OfferAccessToken.findOne({
    tokenHash: hashToken(rawToken),
  }).select('+tokenHash +activeKey');

  if (!tokenRecord || tokenRecord.revokedAt) throw genericFailure();

  return tokenRecord;
};

export const recordOfferTokenView = async (tokenRecordId) => {
  const now = new Date();
  await OfferAccessToken.updateOne(
    { _id: tokenRecordId, revokedAt: null },
    { $set: { lastViewedAt: now }, $inc: { viewCount: 1 } }
  );
};

export const finalizeOfferToken = async ({ tokenRecordId, action }) => {
  await OfferAccessToken.updateOne(
    { _id: tokenRecordId, revokedAt: null },
    {
      $set: {
        finalizedAt: new Date(),
        finalAction: action,
      },
    }
  );
};

export const offerTokenRateLimitKey = (rawToken) => `offer:${hashToken(rawToken || '')}`;
