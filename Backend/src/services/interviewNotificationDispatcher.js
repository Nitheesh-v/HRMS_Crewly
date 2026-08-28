// ─────────────────────────────────────────────────────────────
// Interview notification dispatcher (28.3)
//
// In-app notifications (notifyUser) stay SYNCHRONOUS — they are a
// different channel and remain untouched (§55).
//
// External emails are now async delivery intents:
//   - candidate email: SCHEDULED / RESCHEDULED / CANCELLED
//   - interviewer email: all six events
// Each becomes an EmailDelivery + a BullMQ email job (references
// only; the worker re-loads current interview state and skips
// stale events — e.g. an invitation queued before a cancellation).
//
// Interview.notificationDispatch records that the notification was
// REQUESTED (QUEUED); the final delivery state lives on the
// EmailDelivery record.
// ─────────────────────────────────────────────────────────────
import { JOB_NAMES } from '../config/queueConfig.js';
import { notifyUser } from '../utils/notify.js';
import {
  dispatchEmailDelivery,
  buildEventKey,
} from './emailDeliveryService.js';

export const INTERVIEW_NOTIFICATION_EVENTS = [
  'SCHEDULED',
  'RESCHEDULED',
  'CANCELLED',
  'IN_PROGRESS',
  'COMPLETED',
  'NO_SHOW',
];

const candidateEmailEvents = new Set(['SCHEDULED', 'RESCHEDULED', 'CANCELLED']);

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

// A failed dispatch must never break the business operation or the
// other deliveries — it lands as FAILED on the returned state and
// (when the intent exists) as a reconciliation target.
const safeDispatch = async (dispatch, args) => {
  try {
    const outcome = await dispatch(args);
    return { state: outcome.queued ? 'QUEUED' : 'FAILED', mode: '' };
  } catch {
    return { state: 'FAILED', mode: '' };
  }
};

export const dispatchInterviewNotification = async ({
  event,
  companyId,
  interview,
  candidate,
  interviewers,
  dispatch = dispatchEmailDelivery,
}) => {
  const scheduleVersion = interview.scheduledStartAt
    ? new Date(interview.scheduledStartAt).toISOString()
    : '';

  const candidateDelivery = candidateEmailEvents.has(event)
    ? await safeDispatch(dispatch, {
        jobName: JOB_NAMES.EMAIL_INTERVIEW_CANDIDATE,
        eventType: event,
        // scheduleVersion keeps reschedule #1 distinct from #2.
        eventKey: buildEventKey(
          'INTERVIEW_CANDIDATE',
          interview._id,
          event,
          scheduleVersion
        ),
        companyId,
        entityType: 'INTERVIEW',
        entityId: interview._id,
        recipientType: 'CANDIDATE',
        recipientReference: candidate._id,
        payload: {
          interviewId: interview._id,
          eventType: event,
          scheduleVersion,
        },
      })
    : { state: 'NOT_REQUESTED', mode: '' };

  const interviewerDeliveries = [];
  for (const interviewer of interviewers) {
    await notifyUser(companyId, interviewer._id, {
      type: 'INTERVIEW',
      title: `Interview ${event.toLowerCase().replaceAll('_', ' ')}`,
      message: interviewerMessage({ event, interview, candidate }),
      link: '/app/recruitment/my-interviews',
    });

    const emailDelivery = await safeDispatch(dispatch, {
      jobName: JOB_NAMES.EMAIL_INTERVIEW_INTERVIEWER,
      eventType: event,
      eventKey: buildEventKey(
        'INTERVIEW_INTERVIEWER',
        interview._id,
        interviewer._id,
        event,
        scheduleVersion
      ),
      companyId,
      entityType: 'INTERVIEW',
      entityId: interview._id,
      recipientType: 'INTERVIEWER',
      recipientReference: interviewer._id,
      payload: {
        interviewId: interview._id,
        interviewerId: interviewer._id,
        eventType: event,
        scheduleVersion,
      },
    });

    interviewerDeliveries.push({
      user: interviewer._id,
      emailState: emailDelivery.state,
      emailMode: emailDelivery.mode,
      inAppRequested: true,
    });
  }

  return {
    lastEvent: event,
    lastAttemptAt: new Date(),
    candidate: {
      state: candidateDelivery.state,
      mode: candidateDelivery.mode,
    },
    interviewers: interviewerDeliveries,
  };
};
