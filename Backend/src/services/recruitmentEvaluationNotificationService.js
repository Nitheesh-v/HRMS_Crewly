import { notifyRoles, notifyUser } from '../utils/notify.js';

const interviewLink = (assignedOnly = false) =>
  assignedOnly
    ? '/app/recruitment/my-interviews'
    : '/app/recruitment/interviews';

export const notifyFeedbackPending = async ({
  companyId,
  interview,
  candidate,
  interviewerIds,
}) => {
  await Promise.all(
    (interviewerIds || []).map((interviewerId) =>
      notifyUser(companyId, interviewerId, {
        type: 'RECRUITMENT',
        title: 'Interview feedback pending',
        message: `${interview.interviewCode} for ${candidate.name} is ready for your scorecard.`,
        link: interviewLink(true),
      })
    )
  );
};

export const notifyFeedbackComplete = async ({
  companyId,
  interview,
  candidate,
}) =>
  notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: 'Interview feedback complete',
    message: `All assigned feedback for ${candidate.name} (${interview.interviewCode}) is submitted.`,
    link: interviewLink(false),
  });

export const notifyHumanDecision = async ({
  companyId,
  candidate,
  decision,
}) =>
  notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: 'Candidate decision recorded',
    message: `${candidate.name} is now ${String(decision).toLowerCase().replaceAll('_', ' ')}.`,
    link: `/app/recruitment/candidates/${candidate.candidateCode || candidate._id}`,
  });
