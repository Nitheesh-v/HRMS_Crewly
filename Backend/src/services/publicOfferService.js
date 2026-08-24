import CandidateHistory from '../models/CandidateHistory.js';
import OfferLetter from '../models/OfferLetter.js';
import ApiError from '../utils/ApiError.js';
import { recordAudit } from '../utils/securityauditService.js';
import { offerDecisionConfirmationEmail, sendMail } from '../utils/mailer.js';
import { transitionCandidateStage } from './candidatePipelineService.js';
import { getStoredOfferDocument } from './offerDocumentStorageService.js';
import {
  finalizeOfferToken,
  recordOfferTokenView,
  resolveOfferToken,
} from './offerTokenService.js';
import {
  expireOfferIfDue,
  recordCandidateOfferEvent,
  recordOfferHistory,
  safeOfferDto,
} from './offerService.js';
import { notifyOfferDecision } from './offerNotificationService.js';
import crypto from 'node:crypto';

const genericFailure = () => ApiError.notFound('Offer is unavailable');

const publicDto = (source) => {
  const offer = safeOfferDto(source);
  return {
    offerCode: offer.offerCode,
    status: offer.status,
    candidate: { name: offer.candidateSnapshot.name },
    job: offer.jobSnapshot,
    company: offer.companySnapshot,
    terms: {
      ...offer.terms,
      reportingManager: undefined,
    },
    compensation: offer.compensationSnapshot,
    renderedContent: offer.renderedContent,
    document: offer.document,
    viewedAt: offer.viewedAt,
    acceptedAt: offer.acceptedAt,
    rejectedAt: offer.rejectedAt,
    expiredAt: offer.expiredAt,
    withdrawnAt: offer.withdrawnAt,
  };
};

const rollbackPipeline = async ({ offer, transition, actorId, action }) => {
  if (!transition) return;
  await transitionCandidateStage({
    companyId: offer.companyId,
    candidateId: offer.candidate,
    targetStage: transition.fromStage,
    reason: `${offer.offerCode} decision finalization rolled back`,
    actorId,
    metadata: { source: 'PIPELINE', action, actorType: 'SYSTEM' },
  }).catch(() => {});
};

const authorityFor = async (rawToken) => {
  const tokenRecord = await resolveOfferToken(rawToken);
  const offer = await OfferLetter.findOne({
    _id: tokenRecord.offer,
    companyId: tokenRecord.companyId,
  }).select('+document.storageKey');
  if (!offer) throw genericFailure();

  const expired = tokenRecord.expiresAt.getTime() <= Date.now() ||
    new Date(offer.terms.expiryDate).getTime() <= Date.now();
  if (expired) {
    await expireOfferIfDue({ offer, requestContext: null });
    throw genericFailure();
  }
  if (['WITHDRAWN', 'EXPIRED'].includes(offer.status)) throw genericFailure();

  return { tokenRecord, offer };
};

export const getPublicOffer = async ({ rawToken }) => {
  const { offer } = await authorityFor(rawToken);
  return publicDto(offer);
};

export const recordPublicOfferView = async ({ rawToken, requestContext }) => {
  const { tokenRecord, offer } = await authorityFor(rawToken);
  if (offer.status === 'SENT') {
    const viewedAt = new Date();
    const updated = await OfferLetter.findOneAndUpdate(
      { _id: offer._id, companyId: offer.companyId, status: 'SENT' },
      { $set: { status: 'VIEWED', viewedAt } },
      { new: true }
    );
    if (updated) {
      let candidateEvent = null;
      try {
        candidateEvent = await recordCandidateOfferEvent({
          offer: updated,
          action: 'OFFER_VIEWED',
          actorType: 'PUBLIC_CANDIDATE',
        });
        await recordOfferHistory({
          offer: updated,
          action: 'OFFER_VIEWED',
          fromStatus: 'SENT',
          toStatus: 'VIEWED',
          actor: { type: 'CANDIDATE', name: offer.candidateSnapshot.name },
        });
        await recordAudit({
          req: requestContext,
          action: 'OFFER_VIEWED',
          companyId: offer.companyId,
          actorName: offer.candidateSnapshot.name,
          actorRole: 'CANDIDATE',
          resource: 'OfferLetter',
          resourceId: offer._id,
          critical: true,
        });
        offer.status = 'VIEWED';
        offer.viewedAt = viewedAt;
      } catch (error) {
        if (candidateEvent?._id) {
          await CandidateHistory.deleteOne({
            _id: candidateEvent._id,
            companyId: offer.companyId,
            candidate: offer.candidate,
          }).catch(() => {});
        }
        await OfferLetter.updateOne(
          { _id: offer._id, companyId: offer.companyId, status: 'VIEWED', viewedAt },
          { $set: { status: 'SENT', viewedAt: null } }
        ).catch(() => {});
        throw error;
      }
    }
  }

  await recordOfferTokenView(tokenRecord._id).catch(() => {});
  return publicDto(offer);
};

export const getPublicOfferDocument = async ({ rawToken, requestContext }) => {
  const { offer } = await authorityFor(rawToken);
  if (!['SENT', 'VIEWED', 'ACCEPTED', 'REJECTED'].includes(offer.status)) throw genericFailure();
  if (!offer.document?.storageKey || !offer.document?.checksum) throw genericFailure();

  const buffer = await getStoredOfferDocument({
    storageProvider: offer.document.storageProvider,
    storageKey: offer.document.storageKey,
  });
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  if (checksum !== offer.document.checksum) throw new ApiError(503, 'Offer document is unavailable');
  await recordOfferHistory({
    offer,
    action: 'OFFER_DOCUMENT_ACCESSED',
    actor: { type: 'CANDIDATE', name: offer.candidateSnapshot.name },
    metadata: { documentChecksum: checksum },
  });
  await recordAudit({
    req: requestContext,
    action: 'OFFER_DOCUMENT_ACCESSED',
    companyId: offer.companyId,
    actorName: offer.candidateSnapshot.name,
    actorRole: 'CANDIDATE',
    resource: 'OfferLetter',
    resourceId: offer._id,
    metadata: { offerCode: offer.offerCode, checksum },
    critical: true,
  });
  return { buffer, fileName: offer.document.fileName, checksum };
};

const finalDecisionCommitted = async ({ offer, finalStatus }) =>
  Boolean(
    await OfferHistory.exists({
      offer: offer._id,
      companyId: offer.companyId,
      action: `OFFER_${finalStatus}`,
      toStatus: finalStatus,
    })
  );

const decision = async ({ rawToken, action, rejection = {}, requestContext }) => {
  const { tokenRecord, offer } = await authorityFor(rawToken);
  const finalStatus = action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';

  if (offer.status === finalStatus) {
    if (
      tokenRecord.finalAction === finalStatus ||
      (await finalDecisionCommitted({ offer, finalStatus }))
    ) {
      if (tokenRecord.finalAction !== finalStatus) {
        await finalizeOfferToken({
          tokenRecordId: tokenRecord._id,
          action: finalStatus,
        });
      }
      return { offer: publicDto(offer), idempotent: true };
    }
    throw ApiError.conflict('The offer decision is being finalized. Retry shortly.');
  }
  if (['ACCEPTED', 'REJECTED'].includes(offer.status)) {
    throw ApiError.conflict('A final decision has already been recorded');
  }
  if (!['SENT', 'VIEWED'].includes(offer.status)) throw genericFailure();

  const previousStatus = offer.status;
  const decidedAt = new Date();
  const set = {
    status: finalStatus,
    activeKey: null,
    updatedAt: decidedAt,
  };
  if (finalStatus === 'ACCEPTED') set.acceptedAt = decidedAt;
  else {
    set.rejectedAt = decidedAt;
    set.rejection = {
      category: String(rejection.category || 'NO_REASON').slice(0, 80),
      comment: String(rejection.comment || '').trim().slice(0, 1000),
    };
  }

  const updated = await OfferLetter.findOneAndUpdate(
    { _id: offer._id, companyId: offer.companyId, status: previousStatus },
    { $set: set },
    { new: true, runValidators: true }
  );
  if (!updated) {
    const concurrent = await OfferLetter.findOne({ _id: offer._id, companyId: offer.companyId });
    if (concurrent?.status === finalStatus) {
      const latestToken = await resolveOfferToken(rawToken);
      if (
        latestToken.finalAction === finalStatus ||
        (await finalDecisionCommitted({ offer: concurrent, finalStatus }))
      ) {
        if (latestToken.finalAction !== finalStatus) {
          await finalizeOfferToken({
            tokenRecordId: latestToken._id,
            action: finalStatus,
          });
        }
        return { offer: publicDto(concurrent), idempotent: true };
      }
      throw ApiError.conflict('The offer decision is being finalized. Retry shortly.');
    }
    throw ApiError.conflict('A final decision has already been recorded');
  }

  let transition = null;
  let candidateEvent = null;
  try {
    transition = await transitionCandidateStage({
      companyId: offer.companyId,
      candidateId: offer.candidate,
      targetStage: finalStatus === 'ACCEPTED' ? 'OFFER_ACCEPTED' : 'REJECTED',
      reason:
        finalStatus === 'ACCEPTED'
          ? `Candidate accepted ${offer.offerCode}`
          : `Candidate rejected ${offer.offerCode}${rejection.comment ? `: ${rejection.comment}` : ''}`,
      actorId: offer.approval?.approvedBy || offer.createdBy,
      metadata: {
        source: 'PIPELINE',
        action: finalStatus === 'ACCEPTED' ? 'OFFER_ACCEPTED' : 'OFFER_REJECTED',
        actorType: 'CANDIDATE',
      },
      requestContext,
    });

    candidateEvent = await recordCandidateOfferEvent({
      offer: updated,
      action: finalStatus === 'ACCEPTED' ? 'OFFER_ACCEPTED' : 'OFFER_REJECTED',
      actorType: 'PUBLIC_CANDIDATE',
      metadata: finalStatus === 'REJECTED' ? { category: rejection.category || 'NO_REASON' } : {},
    });
    // The append-only offer history is the final critical decision write.
    await recordOfferHistory({
      offer: updated,
      action: finalStatus === 'ACCEPTED' ? 'OFFER_ACCEPTED' : 'OFFER_REJECTED',
      fromStatus: previousStatus,
      toStatus: finalStatus,
      actor: { type: 'CANDIDATE', name: offer.candidateSnapshot.name },
      reason: rejection.comment || '',
      metadata: finalStatus === 'REJECTED' ? { category: rejection.category || 'NO_REASON' } : {},
    });
  } catch (error) {
    if (candidateEvent?._id) {
      await CandidateHistory.deleteOne({
        _id: candidateEvent._id,
        companyId: offer.companyId,
        candidate: offer.candidate,
      }).catch(() => {});
    }
    await rollbackPipeline({
      offer,
      transition,
      actorId: offer.approval?.approvedBy || offer.createdBy,
      action: 'OFFER_DECISION_ROLLBACK',
    });
    await OfferLetter.updateOne(
      { _id: offer._id, companyId: offer.companyId, status: finalStatus },
      {
        $set: {
          status: previousStatus,
          activeKey: 'ACTIVE',
          acceptedAt: offer.acceptedAt || null,
          rejectedAt: offer.rejectedAt || null,
          rejection: offer.rejection || {},
        },
      }
    ).catch(() => {});
    throw error;
  }

  // The immutable offer history now makes the decision committed. Token
  // finalization is repairable by an idempotent retry and cannot undo it.
  await finalizeOfferToken({
    tokenRecordId: tokenRecord._id,
    action: finalStatus,
  }).catch(() => {});

  await recordAudit({
    req: requestContext,
    action: `OFFER_${finalStatus}`,
    companyId: offer.companyId,
    actorName: offer.candidateSnapshot.name,
    actorRole: 'CANDIDATE',
    resource: 'OfferLetter',
    resourceId: offer._id,
    previousValue: { status: previousStatus },
    newValue: { status: finalStatus },
    critical: true,
  });
  await notifyOfferDecision({ companyId: offer.companyId, offer: updated, action: finalStatus });
  await sendMail({
    to: updated.candidateSnapshot.email,
    ...offerDecisionConfirmationEmail({ offer: updated, decision: finalStatus }),
    sensitive: true,
  });
  return { offer: publicDto(updated), idempotent: false };
};

export const acceptPublicOffer = (options) => decision({ ...options, action: 'ACCEPT' });
export const rejectPublicOffer = (options) => decision({ ...options, action: 'REJECT' });
