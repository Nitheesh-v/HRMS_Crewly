import CandidateHistory from '../models/CandidateHistory.js';
import {
  applicationReceivedEmail,
  sendMail,
} from '../utils/mailer.js';

export const sendApplicationConfirmation = async ({
  candidate,
  company,
  job,
  deliver = sendMail,
}) => {
  let delivery = {
    delivered: false,
    mode: 'UNKNOWN',
    error: 'Email delivery did not complete',
  };

  try {
    const message = applicationReceivedEmail({
      candidateName: candidate.name,
      companyName: company.name,
      jobTitle: job.title,
      jobCode: job.jobCode,
      applicationReference: candidate.candidateCode,
    });

    delivery = await deliver({
      to: candidate.email,
      ...message,
      sensitive: true,
    });
  } catch (error) {
    delivery = {
      delivered: false,
      mode: 'UNKNOWN',
      error: String(error.message || 'Email delivery failed').slice(0, 300),
    };
  }

  const action = delivery?.delivered
    ? 'APPLICATION_CONFIRMATION_SENT'
    : 'APPLICATION_CONFIRMATION_FAILED';

  try {
    await CandidateHistory.create({
      companyId: candidate.companyId,
      candidate: candidate._id,
      job: job._id,
      action,
      source: 'CAREER_PAGE',
      actorType: 'SYSTEM',
      metadata: {
        deliveryMode: delivery?.mode || 'UNKNOWN',
        delivered: Boolean(delivery?.delivered),
      },
      eventAt: new Date(),
    });
  } catch {
    // A confirmation-record failure must not invalidate the application.
  }

  return {
    delivered: Boolean(delivery?.delivered),
    mode: delivery?.mode || 'UNKNOWN',
  };
};
