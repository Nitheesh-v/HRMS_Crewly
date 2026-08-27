import { notifyRoles, notifyUser } from '../utils/notify.js';

const caseLink = (preOnboardingId) =>
  `/app/recruitment/pre-onboarding/${preOnboardingId}`;

export const notifyPreOnboardingStarted = async ({ companyId, preOnboarding }) =>
  notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: 'Pre-onboarding started',
    message: `${preOnboarding.candidateSnapshot.name} entered pre-onboarding for ${preOnboarding.jobSnapshot.title}.`,
    link: caseLink(preOnboarding._id),
  });

export const notifyDocumentUploaded = async ({
  companyId,
  preOnboarding,
  requirementName,
  resubmission = false,
}) =>
  notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: resubmission ? 'Document resubmitted' : 'Document uploaded',
    message: `${preOnboarding.candidateSnapshot.name} ${
      resubmission ? 'resubmitted' : 'uploaded'
    } ${requirementName}.`,
    link: caseLink(preOnboarding._id),
  });

export const notifyAllMandatorySubmitted = async ({ companyId, preOnboarding }) =>
  notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: 'Mandatory documents submitted',
    message: `${preOnboarding.candidateSnapshot.name} submitted all mandatory pre-onboarding documents.`,
    link: caseLink(preOnboarding._id),
  });

export const notifyPreOnboardingReady = async ({ companyId, preOnboarding, actorId }) => {
  await notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: 'Candidate ready to join',
    message: `${preOnboarding.candidateSnapshot.name} is marked ready to join.`,
    link: caseLink(preOnboarding._id),
  });

  if (actorId) {
    await notifyUser(companyId, actorId, {
      type: 'RECRUITMENT',
      title: 'Ready to join confirmed',
      message: `${preOnboarding.preOnboardingCode} is ready for employee conversion in the next phase.`,
      link: caseLink(preOnboarding._id),
    });
  }
};
