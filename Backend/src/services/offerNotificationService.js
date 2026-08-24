import { notifyRoles, notifyUser } from '../utils/notify.js';

const offerLink = (offerId) => `/app/recruitment/offers/${offerId}`;

export const notifyOfferSubmitted = async ({ companyId, offer }) =>
  notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: 'Offer approval requested',
    message: `${offer.offerCode} for ${offer.candidateSnapshot.name} is awaiting approval.`,
    link: offerLink(offer._id),
  });

export const notifyOfferOwner = async ({ companyId, offer, title, message }) =>
  notifyUser(companyId, offer.createdBy, {
    type: 'RECRUITMENT',
    title,
    message,
    link: offerLink(offer._id),
  });

export const notifyOfferDecision = async ({ companyId, offer, action }) =>
  notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: `Offer ${action.toLowerCase()}`,
    message: `${offer.candidateSnapshot.name} ${action.toLowerCase()} ${offer.offerCode}.`,
    link: offerLink(offer._id),
  });
