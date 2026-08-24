import {
  candidateInterviewEmail,
  interviewerAssignmentEmail,
  sendMail,
} from '../utils/mailer.js';
import { notifyUser } from '../utils/notify.js';
import { formatInterviewSchedule } from '../utils/interviewDateTime.js';

export const INTERVIEW_NOTIFICATION_EVENTS = [
  'SCHEDULED',
  'RESCHEDULED',
  'CANCELLED',
  'IN_PROGRESS',
  'COMPLETED',
  'NO_SHOW',
];

const candidateEmailEvents = new Set([
  'SCHEDULED',
  'RESCHEDULED',
  'CANCELLED',
]);

const interviewerMessage = ({ event, interview, candidate }) => {
  const verb = {
    SCHEDULED: 'has been scheduled',
    RESCHEDULED: 'has been rescheduled',
    CANCELLED: 'has been cancelled',
    IN_PROGRESS: 'is now in progress',
    COMPLETED: 'has been completed',
    NO_SHOW: 'was marked as a no-show',
  }[event] || 'was updated';

  return `${interview.round.name} for ${candidate.name} ${verb}.`;
};

export const dispatchInterviewNotification = async ({
  event,
  companyId,
  companyName,
  interview,
  candidate,
  job,
  interviewers,
}) => {
  const scheduleLabel = formatInterviewSchedule({
    startAt: interview.scheduledStartAt,
    timezone: interview.timezone,
  });
  const candidateDelivery = candidateEmailEvents.has(event)
    ? await sendMail({
        to: candidate.email,
        ...candidateInterviewEmail({
          event,
          candidateName: candidate.name,
          companyName,
          jobTitle: job.title,
          interviewCode: interview.interviewCode,
          roundName: interview.round.name,
          scheduleLabel,
          interviewType: interview.interviewType,
          meetingLink: event === 'CANCELLED' ? '' : interview.meetingLink,
          location: event === 'CANCELLED' ? '' : interview.location,
          instructions:
            event === 'CANCELLED' ? '' : interview.candidateInstructions,
        }),
        sensitive: true,
      })
    : { delivered: false, mode: '', notRequested: true };

  const interviewerDeliveries = await Promise.all(
    interviewers.map(async (interviewer) => {
      await notifyUser(companyId, interviewer._id, {
        type: 'INTERVIEW',
        title: `Interview ${event.toLowerCase().replaceAll('_', ' ')}`,
        message: interviewerMessage({ event, interview, candidate }),
        link: '/app/recruitment/my-interviews',
      });

      const emailDelivery = await sendMail({
        to: interviewer.email,
        ...interviewerAssignmentEmail({
          event,
          interviewerName: interviewer.name,
          candidateName: candidate.name,
          candidateEmail: candidate.email,
          companyName,
          jobTitle: job.title,
          interviewCode: interview.interviewCode,
          roundName: interview.round.name,
          scheduleLabel,
          interviewType: interview.interviewType,
          meetingLink: event === 'CANCELLED' ? '' : interview.meetingLink,
          location: event === 'CANCELLED' ? '' : interview.location,
          internalNotes: event === 'CANCELLED' ? '' : interview.internalNotes,
        }),
        sensitive: true,
      });

      return {
        user: interviewer._id,
        emailState: emailDelivery.delivered ? 'DELIVERED' : 'FAILED',
        emailMode: emailDelivery.mode || '',
        inAppRequested: true,
      };
    })
  );

  return {
    lastEvent: event,
    lastAttemptAt: new Date(),
    candidate: {
      state: candidateDelivery.notRequested
        ? 'NOT_REQUESTED'
        : candidateDelivery.delivered
          ? 'DELIVERED'
          : 'FAILED',
      mode: candidateDelivery.mode || '',
    },
    interviewers: interviewerDeliveries,
  };
};
